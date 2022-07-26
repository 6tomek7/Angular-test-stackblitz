import { Component, OnInit } from '@angular/core';
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Component({
  selector: 'app-config',
  templateUrl: './config.component.html',
  styleUrls: ['./config.component.css']
})

@Injectable()
export class ConfigComponent implements OnInit {
  

  constructor(private http: HttpClient) { }

  ngOnInit(): void {
  }

}
